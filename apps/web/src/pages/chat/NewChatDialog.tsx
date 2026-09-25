import { component, signal, watch, type Define } from 'sigx';
import { BYPASS_PERMISSIONS_MODE, accountRefOf, environmentsForAccount, type AccountRef, type ProjectRecord } from '@agentic/core';
import { RadioGroup } from '@sigx/zero';
import { derivedModel } from '@sigx/zero/behaviors';
import { Link } from '@sigx/router';
import { Checkbox, Field } from '@sigx/zero-daisyui/components';
import { ErrorNote, FormDialog, SelectField, type WorkdirEnvironment } from '@agentic/ui';
import type { AgentIdentity } from './live';
import { MemberPicker } from './MemberPicker';
import { DEFAULT_PERMISSION_MODE, modeChoices } from './member-options';
import { projectForOrigin, type NewChatPrefill } from './new-chat-prefill';
import type { MachineEntry } from '../ops/environments';

/** What the picker needs of a project: `ProjectRecord` fits. `features` names the repo (#336) when the project has the git feature. */
export type NewChatProject = Pick<ProjectRecord, 'id' | 'name' | 'members' | 'folders' | 'connectors'> & { readonly features?: ProjectRecord['features'] };

/** The folder the chat starts in (#336): saved on the project for its environment, or set on every member that runs there. */
export interface NewChatWorkdir {
    readonly environmentId: string;
    readonly path: string;
    /** `true`: record it as the picked project's folder on that environment (the project had none there). */
    readonly saveToProject: boolean;
}

export interface NewChatCreate {
    readonly agentIds: readonly string[];
    readonly coordinator: string | null;
    readonly projectId: string | null;
    /** The machine the chat runs on (#414): every member's account is resolved there; `null` when the workspace has no machine to pick. */
    readonly machineId: string | null;
    /** Only from a prefilled opening. */
    readonly workdir?: NewChatWorkdir;
    /** The permission mode the chat's Claude Code members start in (#698); absent for the runtime's `default`. */
    readonly permissionMode?: { readonly mode: string; readonly agentIds: readonly string[] };
}

/** The account a member runs as (#414): its own, else the login of its pinned environment as the machines report it; `undefined` for a platform runtime or an unassigned agent. */
export function memberAccount(agent: Pick<AgentIdentity, 'environment' | 'environmentId' | 'account'>, machines: readonly MachineEntry[]): AccountRef | undefined {
    if (agent.environment.runtime === 'anthropic-api') return undefined;
    if (agent.account) return agent.account;
    const pinned = agent.environmentId ? machines.flatMap((m) => m.environments).find((e) => e.id === agent.environmentId) : undefined;
    return pinned ? accountRefOf(pinned) : undefined;
}

/** Where a member would run on `machine` (#414): the pin as the machine reports it, else its account's environment there, else nothing. */
export function memberEnvironmentOn(agent: Pick<AgentIdentity, 'environment' | 'environmentId' | 'account'>, machine: MachineEntry, machines: readonly MachineEntry[]): string | undefined {
    if (agent.environment.runtime === 'anthropic-api') return undefined;
    if (!agent.account && agent.environmentId && machine.environments.some((e) => e.id === agent.environmentId)) return agent.environmentId;
    const ref = memberAccount(agent, machines);
    return ref ? environmentsForAccount(machine.environments, agent.environment.runtime, ref)[0]?.id : undefined;
}

/** The machines a New chat offers (#414): online first, index order within; `null` when there is none to pick. */
export function machineChoices(machines: readonly MachineEntry[]): MachineEntry[] {
    return [...machines].sort((a, b) => Number(b.online) - Number(a.online));
}

/** The machine an opening starts on (#414): the prefill's environment's, else the last used one, else the first online — or none. */
export function openingMachine(machines: readonly MachineEntry[], lastMachineId: string | null | undefined, prefillEnvironmentId?: string): string {
    if (prefillEnvironmentId) {
        const reporting = machines.find((m) => m.environments.some((e) => e.id === prefillEnvironmentId));
        if (reporting) return reporting.id;
    }
    if (lastMachineId && machines.some((m) => m.id === lastMachineId)) return lastMachineId;
    return machineChoices(machines)[0]?.id ?? '';
}

/**
 * Who a New chat's permission mode applies to on `machine` (#698): the picked members on Claude Code. `bypassPermissions`
 * is offered only when each of them has an environment there that allows it — and is then the default.
 */
export function permissionScope(picked: readonly Pick<AgentIdentity, 'id' | 'environment' | 'environmentId' | 'account'>[], machine: MachineEntry | undefined, machines: readonly MachineEntry[]): { agentIds: string[]; bypassAllowed: boolean } {
    const members = picked.filter((a) => a.environment.runtime === 'claude-code');
    const bypassAllowed = !!machine && members.length > 0 && members.every((a) => {
        const id = memberEnvironmentOn(a, machine, machines);
        return machine.environments.some((e) => e.id === id && e.allowBypassPermissions === true);
    });
    return { agentIds: members.map((a) => a.id), bypassAllowed };
}

/** "This folder is not in a project yet" (#336): the chat alone, or a project made from the folder. */
const PREFILL_MODES = [
    { value: 'chat', label: 'Just this chat' },
    { value: 'project', label: 'Create project from this folder' }
];

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
    /** The paired machines and what they report (#414): the "Machine" choice; absent or empty, the dialog offers none and `create` carries `machineId: null`. */
    & Define.Prop<'machines', readonly MachineEntry[]>
    /** The machine used last (`Workspace.get().lastMachineId`): preselected when the dialog opens. */
    & Define.Prop<'lastMachineId', string | null>
    /** The folder the chat starts in (#336, `/chats/new?env=&path=&origin=`): its project preselected when the origin matches one. */
    & Define.Prop<'prefill', NewChatPrefill>
    & Define.Prop<'busy', boolean>
    & Define.Event<'create', NewChatCreate>
    /** "Create project from this folder": the caller opens the project form prefilled with it. */
    & Define.Event<'createProject', NewChatPrefill>
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
 *
 * Opened from a folder (#336, `agentic-daemon open`): the project whose git
 * feature names the folder's origin is preselected over the last used one,
 * and when it has no folder on that environment yet a checked line offers to
 * save this one. With no such project the folder is not in a project yet:
 * "Just this chat" (the default) runs the chat's members there, "Create
 * project from this folder" hands the folder to the project form.
 *
 * With Claude Code members on a machine (#698) a "Permissions" choice says the mode they start in:
 * `bypassPermissions` (`--dangerously-skip-permissions`) by default where every one of them may run it there,
 * else the runtime's `default`, with a line naming the machine page where bypass is allowed.
 */
export const NewChatDialog = component<NewChatDialogProps>(({ props, emit }) => {
    const projectOf = (id: string): NewChatProject | undefined => props.projects?.find((p) => p.id === id);
    /**
     * The project an opening starts on: the one the prefill's origin names — a repo no project names starts on none,
     * never on the last used project's folder line — else the last used one, when the workspace still has it.
     */
    const openingProject = (): string => {
        if (props.prefill?.origin) return projectForOrigin(props.projects ?? [], props.prefill.origin)?.id ?? '';
        return props.lastProjectId && projectOf(props.lastProjectId) ? props.lastProjectId : '';
    };
    /** The roster a project names — the members the workspace still has, and the coordinator when it is one of them. */
    const rosterOf = (id: string): { picked: string[]; coordinator: string } => {
        const p = projectOf(id);
        if (!p) return { picked: [], coordinator: '' };
        const picked = p.members.agentIds.filter((a) => props.agents.some((x) => x.id === a));
        return { picked, coordinator: p.members.coordinator && picked.includes(p.members.coordinator) ? p.members.coordinator : '' };
    };
    const machinesOf = (): readonly MachineEntry[] => props.machines ?? [];
    // Mounted open (the tests): already on the opening project and its roster.
    const first = props.model?.value === true ? openingProject() : '';
    const st = signal({ ...rosterOf(first), attempted: false, project: first, saveFolder: true, mode: 'chat' as 'chat' | 'project', permission: '', machine: props.model?.value === true ? openingMachine(machinesOf(), props.lastMachineId, props.prefill?.environmentId) : '' });
    const toggle = (id: string, on: boolean): void => {
        st.picked = on ? [...new Set([...st.picked, id])] : st.picked.filter((p) => p !== id);
        if (!on && st.coordinator === id) st.coordinator = '';
        if (on) st.attempted = false;
    };
    const nameOf = (id: string): string => props.agents.find((a) => a.id === id)?.name ?? id;
    /** The roster of `id` — empty for "No project" — replaces what is picked. */
    const applyRoster = (id: string): void => {
        Object.assign(st, rosterOf(id));
        st.attempted = false;
    };
    /** A person's pick in the select fills the roster from the project; "No project" keeps what is picked, editable. */
    const applyProject = (id: string): void => {
        if (projectOf(id)) applyRoster(id);
    };
    // Each opening starts afresh: on the opening project and the roster it names, or on nobody — a roster
    // picked in an earlier opening never carries over. The same when the projects, the last id or the prefill land
    // while the dialog is open. Not `immediate`: the initial state above covers the mount, and a watch callback that
    // runs inside setup must not read `st` (it would become a dependency of the key).
    let syncing = false;
    watch(
        () => (props.model?.value === true ? `open\n${props.lastProjectId ?? ''}\n${props.projects?.length ?? 0}\n${props.agents.length}\n${props.prefill?.environmentId ?? ''}\n${props.prefill?.origin ?? ''}\n${props.prefill?.path ?? ''}\n${props.lastMachineId ?? ''}\n${machinesOf().map((m) => m.id).join(',')}` : ''),
        (key, prev) => {
            if (!key) return;
            const opening = openingProject();
            if (st.project !== opening) {
                syncing = true;
                st.project = opening;
            }
            // Opened (from closed): the roster restarts; landed while open: the project's roster takes over.
            if (!prev || opening) applyRoster(opening);
            if (!prev) {
                st.saveFolder = true;
                st.mode = 'chat';
                st.permission = '';
            }
            // The machine (#414): the opening one until a person picks another; a pick that the machines no longer list restarts.
            if (!prev || !st.machine || !machinesOf().some((m) => m.id === st.machine)) st.machine = openingMachine(machinesOf(), props.lastMachineId, props.prefill?.environmentId);
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
    /** What the folder means for this chat, given the project in effect (#336). */
    const workdirOf = (project: NewChatProject | undefined): NewChatWorkdir | undefined => {
        const prefill = props.prefill;
        if (!prefill) return undefined;
        const has = project ? typeof project.folders[prefill.environmentId as keyof typeof project.folders] === 'string' : true;
        return { environmentId: prefill.environmentId, path: prefill.path, saveToProject: !!project && !has && st.saveFolder };
    };
    /** The mode (#698): a person's pick while the machine still allows it, else bypass where allowed, else the runtime's own. */
    const permissionInEffect = (): { scope: ReturnType<typeof permissionScope>; modes: ReturnType<typeof modeChoices>; mode: string } => {
        const machine = machinesOf().find((m) => m.id === st.machine);
        const scope = permissionScope(st.picked.map((id) => props.agents.find((a) => a.id === id)).filter((a): a is AgentIdentity => a !== undefined), machine, machinesOf());
        const modes = scope.agentIds.length && machine ? modeChoices('claude-code', { allowBypassPermissions: scope.bypassAllowed }) : [];
        const mode = modes.some((m) => m.id === st.permission) ? st.permission : scope.bypassAllowed ? BYPASS_PERMISSIONS_MODE : DEFAULT_PERMISSION_MODE;
        return { scope, modes, mode };
    };
    const permissionModel = derivedModel<string>(() => permissionInEffect().mode, (mode) => { st.permission = mode; });
    return () => {
        const group = st.picked.length > 1;
        const project = projectOf(st.project);
        const machines = machineChoices(machinesOf());
        const machine = machines.find((m) => m.id === st.machine);
        /** Whether each picked member has a login on `m` (#414): a flag, never a block — the router explains at run. */
        const signedIn = (m: MachineEntry): { agent: AgentIdentity; environmentId: string | undefined }[] =>
            st.picked.map((id) => props.agents.find((a) => a.id === id)).filter((a): a is AgentIdentity => a !== undefined && a.environment.runtime !== 'anthropic-api').map((agent) => ({ agent, environmentId: memberEnvironmentOn(agent, m, machinesOf()) }));
        /** Where a picked member's quota is read from on the chosen machine (#414), for the cards — and the machine, so a member with no login there says so. */
        const quotaEnvironmentOf = (agent: AgentIdentity): string | undefined => (machine ? memberEnvironmentOn(agent, machine, machinesOf()) : undefined);
        const quotaMachine = machine
            ? { machineId: machine.id, machineName: machine.name, accountEnvironment: (id: string, runtime: string, ref: AccountRef) => { const m = machinesOf().find((x) => x.id === id); return m ? environmentsForAccount(m.environments, runtime, ref)[0]?.id : undefined; } }
            : undefined;
        const envLabel = (id: string): string => props.environments?.find((e) => e.id === id)?.label ?? id;
        const folders = project ? Object.entries(project.folders).filter((e): e is [string, string] => typeof e[1] === 'string') : [];
        const prefill = props.prefill;
        const creatingProject = !!prefill && !project && st.mode === 'project';
        const { scope, modes, mode: permission } = permissionInEffect();
        const projectFolder = prefill && project ? project.folders[prefill.environmentId as keyof typeof project.folders] : undefined;
        return (
            <FormDialog
                model={props.model}
                title="New chat"
                description="Who is in it? Pick one agent for a direct chat, or several for a group. Each card shows where the agent runs and how much of that account’s plan is left."
                submitLabel={creatingProject ? 'Create project' : st.picked.length > 1 ? `Create chat with ${st.picked.length}` : 'Create chat'}
                busy={props.busy}
                onSubmit={() => {
                    if (creatingProject) {
                        emit('createProject', prefill);
                        return;
                    }
                    // A chat needs at least one member (CHT-01): confirming with none picked keeps the dialog open.
                    if (!st.picked.length) {
                        st.attempted = true;
                        return;
                    }
                    const workdir = workdirOf(project);
                    const permissionMode = modes.length && permission !== DEFAULT_PERMISSION_MODE ? { mode: permission, agentIds: scope.agentIds } : undefined;
                    emit('create', { agentIds: st.picked, coordinator: st.coordinator || null, projectId: st.project || null, machineId: st.machine || null, ...(workdir ? { workdir } : {}), ...(permissionMode ? { permissionMode } : {}) });
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
                {prefill ? (
                    <div data-new-chat-prefill data-prefill-project={project ? project.id : undefined}>
                        {project ? (
                            typeof projectFolder === 'string' ? (
                                <p data-new-chat-prefill-line>
                                    {projectFolder === prefill.path
                                        ? `Runs in ${prefill.path} on ${envLabel(prefill.environmentId)}, the project's folder there.`
                                        : `Runs in ${prefill.path} on ${envLabel(prefill.environmentId)} (the project's folder there is ${projectFolder}).`}
                                </p>
                            ) : (
                                <Checkbox.Root model={() => st.saveFolder} name="chat-save-folder" data-new-chat-save-folder="">
                                    Save {prefill.path} as this project's folder on {envLabel(prefill.environmentId)}
                                </Checkbox.Root>
                            )
                        ) : (
                            <div data-new-chat-prefill-choice>
                                <Field.Root>
                                    <Field.Label>This folder is not in a project yet</Field.Label>
                                    <p data-new-chat-prefill-line>{prefill.path} on {envLabel(prefill.environmentId)}</p>
                                    <RadioGroup.Root model={() => st.mode} name="chat-prefill-mode" items={PREFILL_MODES} />
                                </Field.Root>
                            </div>
                        )}
                    </div>
                ) : null}
                {machines.length ? (
                    <div data-new-chat-machine>
                        <Field.Root>
                        <Field.Label>Machine</Field.Label>
                        <Field.Description data-new-chat-machine-note="">Where the chat's members run: each one under its account on that machine. Change it later from the chat's settings.</Field.Description>
                        <RadioGroup.Root model={() => st.machine} name="chat-machine">
                        {machines.map((m) => {
                            const flags = st.picked.length ? signedIn(m) : [];
                            const missing = flags.filter((f) => f.environmentId === undefined);
                            return (
                                <RadioGroup.Item key={m.id} value={m.id} data-new-chat-machine-choice={m.id} data-online={m.online ? '' : undefined}>
                                    <span data-new-chat-machine-name>{m.name}{m.os ? ` · ${m.os}` : ''}{m.online ? '' : ' · offline'}</span>
                                    {flags.length ? (
                                        <span data-new-chat-machine-accounts>
                                            {flags.map((f) => (
                                                <span key={f.agent.id} data-new-chat-machine-account={f.agent.id} data-tone={f.environmentId === undefined ? 'needs-you' : 'live'}>
                                                    {f.agent.name}: {f.environmentId === undefined ? 'not signed in here' : `${f.agent.environment.account} signed in`}
                                                </span>
                                            ))}
                                        </span>
                                    ) : null}
                                    {missing.length && st.machine === m.id ? <span data-new-chat-machine-warning role="status">{missing.length === 1 ? `${missing[0]!.agent.name} has no login on ${m.name} — its messages will fail until it signs in there.` : `${missing.length} members have no login on ${m.name}.`}</span> : null}
                                </RadioGroup.Item>
                            );
                        })}
                        </RadioGroup.Root>
                        </Field.Root>
                    </div>
                ) : null}
                {modes.length ? (
                    <div data-new-chat-permission data-mode={permission}>
                        <SelectField
                            model={permissionModel}
                            name="chat-permission-mode"
                            label="Permissions"
                            options={modes.map((m) => ({ value: m.id, label: m.hint ? `${m.label} — ${m.hint}` : m.label }))}
                            description="The mode the chat's Claude Code members start in. Change it per member later from the chat's settings."
                        />
                        {scope.bypassAllowed ? null : (
                            <p data-new-chat-permission-note="">
                                bypassPermissions (--dangerously-skip-permissions) is off on {machine!.name}: allow it for the environment on <Link to={`/machines/${machine!.id}`}>the machine's page</Link>.
                            </p>
                        )}
                    </div>
                ) : null}
                <MemberPicker agents={props.agents} environments={props.environments} picked={st.picked} coordinator={st.coordinator} quotaEnvironmentOf={machine ? quotaEnvironmentOf : undefined} {...(quotaMachine ? { quotaMachine } : {})} onToggle={(e) => toggle(e.id, e.on)} onPickCoordinator={(id) => { st.coordinator = id; }} />
                <div data-new-chat-summary aria-live="polite">
                    {!st.picked.length
                        ? (st.attempted ? <ErrorNote data-new-chat-required="">Pick at least one agent.</ErrorNote> : 'Nobody picked yet.')
                        : !group
                            ? `A direct chat with ${nameOf(st.picked[0]!)}.`
                            : st.coordinator
                                ? <>A group of {st.picked.length}. {nameOf(st.coordinator)} answers unless you mention someone. <button type="button" data-link-button onClick={() => { st.coordinator = ''; }}>No coordinator</button></>
                                : `A group of ${st.picked.length}, no coordinator: mention an agent to address it.`}
                </div>
            </FormDialog>
        );
    };
});
