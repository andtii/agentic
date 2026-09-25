/**
 * New project (#733, PRJ-18): a short dialog in two steps. First the project — name, description and an optional
 * folder, browsed on a machine or found by its repo (`locate`). Then its **Project manager**: a suggested name, a
 * personality (a preset card with a line of how it talks, or custom text) and skills. Create sends one patch with
 * `pm: ProjectManagerSpec`; the platform creates the manager agent (#784). Everything else is in the project's
 * settings tabs.
 */
import { component, signal, watch, type Define } from 'sigx';
import { projectFolderKey, PM_PERSONALITIES, type MachineId, type ProjectPatch } from '@agentic/core';
import { RadioGroup } from '@sigx/zero';
import { Field } from '@sigx/zero-daisyui/components';
import { Button, ChipInput, ErrorNote, FormDialog, Tag, TextField, TextareaField, gitBadgeText, type WorkdirSelection } from '@agentic/ui';
import { WorkdirInput } from '../../workdir/WorkdirInput';
import type { LocateBackend } from '../locate';
import { reaches, resolveFolders, type ProjectDraft, type ProjectMachine } from '../model';
import { blankNewProject, CUSTOM_PERSONALITY, newProjectPatchOf, PERSONALITY_SAMPLES, suggestedPmName, validateNewProject, type NewProjectDraft } from './model';

export type NewProjectDialogProps =
    & Define.Model<boolean>
    /** Every paired machine with its environments: the folder is picked on one of them. */
    & Define.Prop<'machines', readonly ProjectMachine[], true>
    & Define.Prop<'locate', LocateBackend, true>
    /** Skills to offer as chips; any other can be typed. */
    & Define.Prop<'skills', readonly { readonly value: string; readonly label?: string }[]>
    /** What the dialog opens on (#336, `projectPrefillOf`): a name and a folder, as if picked. */
    & Define.Prop<'initial', Partial<ProjectDraft>>
    & Define.Prop<'busy', boolean>
    /** What the create answered when it refused. */
    & Define.Prop<'error', string>
    & Define.Event<'create', ProjectPatch>
    & Define.Event<'cancel'>;

type Git = NonNullable<NonNullable<NewProjectDraft['folder']>['row']['git']>;
/** A prefilled folder carries the origin and no HEAD, so its badge is the kind alone, not "detached". */
const badgeText = (git: Git): string => (git.branch || git.head ? gitBadgeText(git) : git.kind);

/** The dialog's opening state: blank, or the prefill's name and its first folder placed on a machine (#702). */
function openingDraft(initial: Partial<ProjectDraft> | undefined, machines: readonly ProjectMachine[]): NewProjectDraft {
    const d = blankNewProject();
    if (initial?.name) d.name = initial.name;
    const first = Object.entries(resolveFolders(initial?.folders ?? {}, machines))[0];
    if (first) d.folder = { key: first[0], row: first[1] };
    return d;
}

export const NewProjectDialog = component<NewProjectDialogProps>(({ props, emit }) => {
    const st = signal({ ...openingDraft(props.initial, props.machines), attempted: false, origin: '', match: '' });
    // The machines may land after the dialog opened (live): a prefilled folder waiting for its machine is placed then.
    watch(
        () => props.machines.length,
        () => {
            if (!st.folder && props.initial?.folders) Object.assign(st, { folder: openingDraft(props.initial, props.machines).folder });
        }
    );
    const environments = () => props.machines.flatMap((m) => m.environments);
    const machineOf = (environmentId: string): string | undefined => props.machines.find((m) => m.environments.some((e) => e.id === environmentId))?.id;
    const setFolder = (pick: WorkdirSelection | null): void => {
        const machine = pick ? machineOf(pick.environmentId) : undefined;
        st.folder = pick && machine ? { key: projectFolderKey(machine as MachineId), row: { path: pick.path, ...(pick.git ? { git: pick.git } : {}) } } : null;
    };
    const folderMachine = (): ProjectMachine | undefined => {
        const key = st.folder?.key;
        return key ? props.machines.find((m) => key === projectFolderKey(m.id as MachineId)) : undefined;
    };
    /** Find the repo's checkouts under the roots of the first environment that can search. */
    const find = (): void => {
        const origin = st.origin.trim();
        const env = environments().find((e) => !e.unavailable);
        if (!origin || !env) return;
        st.match = '';
        props.locate.start(env.id, origin, machineOf(env.id));
    };
    const useMatch = (path: string, git: Git): void => {
        const env = props.locate.state.environmentId;
        const machine = env ? machineOf(env) : undefined;
        if (!machine) return;
        st.folder = { key: projectFolderKey(machine as MachineId), row: { path, git } };
        props.locate.reset();
    };
    const reset = (): void => {
        Object.assign(st, openingDraft(props.initial, props.machines), { attempted: false, origin: '', match: '' });
        props.locate.reset();
    };
    const submit = (): void => {
        st.attempted = true;
        if (Object.keys(validateNewProject(st)).length) return;
        st.attempted = false;
        if (st.step === 'project') {
            st.step = 'manager';
            if (!st.pmName.trim()) st.pmName = suggestedPmName(st.name);
            return;
        }
        emit('create', newProjectPatchOf(st));
    };

    return () => {
        const errors = st.attempted ? validateNewProject(st) : {};
        const found = props.locate.state;
        const machine = folderMachine();
        const env = machine && st.folder ? (machine.environments.find((e) => reaches(e, st.folder!.row.path)) ?? machine.environments[0]) : undefined;
        const manager = st.step === 'manager';
        return (
            <FormDialog
                model={props.model}
                title={manager ? 'Project manager' : 'New project'}
                description={manager
                    ? `Every project has a manager agent: it keeps the plan, assigns work and takes requests. Pick how ${st.name.trim() || 'the project'}'s talks and works.`
                    : 'A name is enough. Members, connectors and features are in the project’s settings.'}
                submitLabel={manager ? 'Create project' : 'Next: project manager'}
                busy={props.busy}
                onSubmit={submit}
                onCancel={() => { reset(); emit('cancel'); }}
            >
                <div data-new-project data-step={st.step}>
                    <ol data-new-project-steps aria-label="Steps">
                        <li aria-current={manager ? undefined : 'step'}>Project</li>
                        <li aria-current={manager ? 'step' : undefined}>Project manager</li>
                    </ol>
                    {manager ? (
                        <>
                            <TextField model={() => st.pmName} name="pm-name" label="Name" description="Suggested from the project; members see it in chats and on the plan." />
                            <Field.Root invalid={!!errors.personality}>
                                <Field.Label>Personality</Field.Label>
                                <RadioGroup.Root model={() => st.personality} name="pm-personality" data-pm-personalities="">
                                    {PM_PERSONALITIES.map((p) => (
                                        <RadioGroup.Item key={p.id} value={p.id} data-pm-personality={p.id}>
                                            <span data-pm-personality-label>{p.label}</span>
                                            <span data-pm-personality-summary>{p.summary}</span>
                                            <span data-pm-personality-sample>{PERSONALITY_SAMPLES[p.id] ?? ''}</span>
                                        </RadioGroup.Item>
                                    ))}
                                    <RadioGroup.Item value={CUSTOM_PERSONALITY} data-pm-personality={CUSTOM_PERSONALITY}>
                                        <span data-pm-personality-label>Custom</span>
                                        <span data-pm-personality-summary>Write how it works in your own words.</span>
                                    </RadioGroup.Item>
                                </RadioGroup.Root>
                                {errors.personality ? <Field.Error>{errors.personality}</Field.Error> : null}
                            </Field.Root>
                            {st.personality === CUSTOM_PERSONALITY
                                ? <TextareaField model={() => st.pmCustom} name="pm-custom" label="How it works" rows={3} placeholder="You are a pragmatic project manager who…" />
                                : null}
                            <div data-pm-skills>
                                <Field.Root>
                                    <Field.Label>Skills</Field.Label>
                                    <ChipInput model={() => st.skills} name="pm-skills" options={props.skills ?? []} allowCustom placeholder="Add a skill…" />
                                </Field.Root>
                            </div>
                            <Button intent="default" icon="back" disabled={!!props.busy} onClick={() => { st.step = 'project'; }}>Back</Button>
                        </>
                    ) : (
                        <>
                            <TextField model={() => st.name} name="project-name" label="Name" required error={errors.name} />
                            <TextareaField model={() => st.description} name="project-description" label="Description" rows={2} description="What the project is, for the people and agents in it." />
                            <div data-project-folder={machine?.id ?? ''}>
                                <WorkdirInput
                                    value={st.folder && env ? { environmentId: env.id, path: st.folder.row.path } : null}
                                    environments={environments()}
                                    machineOf={machineOf}
                                    label="Folder"
                                    description="Optional: where the project lives on one machine. Add the others under Settings › Folders."
                                    placeholder="No folder: it runs on the platform"
                                    name="project-folder"
                                    disabled={!!props.busy || !environments().length}
                                    onChange={setFolder}
                                />
                                {st.folder?.row.git ? <span data-project-folder-meta><Tag>{badgeText(st.folder.row.git)}</Tag></span> : null}
                            </div>
                            {!st.folder && environments().length ? (
                                <div data-new-project-find>
                                    <TextField model={() => st.origin} name="project-origin" label="Or find a checkout of a repo" placeholder="git@github.com:you/repo.git" />
                                    <Button intent="default" icon="search" disabled={!!props.busy || !st.origin.trim() || found.status === 'loading'} onClick={find}>Find</Button>
                                    {found.status === 'loading' ? <p data-panel-note data-project-locate="loading">Searching…</p> : null}
                                    {found.status === 'error' ? <ErrorNote data-project-locate="error">{found.error?.message ?? 'The machine could not search.'}</ErrorNote> : null}
                                    {found.status === 'done' && !found.matches.length ? <p data-panel-note data-project-locate="empty">No checkout of that repo under the roots. Browse to one instead.</p> : null}
                                    {found.status === 'done' && found.matches.length ? (
                                        <ul data-project-locate="matches">
                                            {found.matches.map((m) => (
                                                <li key={m.path} data-project-match="">
                                                    <span data-project-match-path>{m.path}</span>
                                                    <Tag>{gitBadgeText(m.git)}</Tag>
                                                    <Button intent="default" onClick={() => useMatch(m.path, m.git)}>Use</Button>
                                                </li>
                                            ))}
                                        </ul>
                                    ) : null}
                                </div>
                            ) : null}
                        </>
                    )}
                    {props.error ? <ErrorNote data-project-error="">{props.error}</ErrorNote> : null}
                </div>
            </FormDialog>
        );
    };
}, { name: 'NewProjectDialog' });
